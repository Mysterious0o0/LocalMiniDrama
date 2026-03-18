const path = require('path');
const fs = require('fs');
const crypto = require('crypto'); // 引入 crypto 处理高并发文件名冲突
const { spawnSync } = require('child_process');
const { getFfmpegPath, hasLocalFfmpeg } = require('../utils/ffmpegPath');

function list(db, query) {
  let sql = 'FROM video_merges WHERE deleted_at IS NULL';
  const params = [];
  if (query.episode_id) {
    sql += ' AND episode_id = ?';
    params.push(query.episode_id);
  }
  if (query.drama_id) {
    sql += ' AND drama_id = ?';
    params.push(query.drama_id);
  }
  const rows = db.prepare('SELECT * ' + sql + ' ORDER BY created_at DESC').all(...params);
  return rows.map(rowToItem);
}

function rowToItem(r) {
  return {
    id: r.id,
    episode_id: r.episode_id,
    drama_id: r.drama_id,
    title: r.title,
    provider: r.provider,
    status: r.status,
    merged_url: r.merged_url,
    duration: r.duration ?? undefined,
    task_id: r.task_id,
    error_msg: r.error_msg ?? undefined,
    created_at: r.created_at,
    completed_at: r.completed_at,
  };
}

function getById(db, id) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  return r ? rowToItem(r) : null;
}

function create(db, log, req) {
  const now = new Date().toISOString();
  const taskService = require('./taskService');
  const task = taskService.createTask(db, log, 'video_merge', String(req.episode_id || ''));
  const info = db.prepare(
    `INSERT INTO video_merges (episode_id, drama_id, title, provider, model, status, scenes, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
  ).run(
    Number(req.episode_id) || 0,
    Number(req.drama_id) || 0,
    req.title ?? null,
    req.provider || 'ffmpeg',
    req.model ?? null,
    req.scenes ? JSON.stringify(req.scenes) : '[]',
    task.id,
    now
  );
  return { merge_id: info.lastInsertRowid, task_id: task.id, ...getById(db, info.lastInsertRowid) };
}

function deleteById(db, log, id) {
  const now = new Date().toISOString();
  const result = db.prepare('UPDATE video_merges SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, Number(id));
  return result.changes > 0;
}

/** 获取 storage 根目录（绝对路径） */
function getStorageRoot() {
  const loadConfig = require('../config').loadConfig;
  const cfg = loadConfig();
  const p = cfg.storage?.local_path || './data/storage';
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

/** 将 video_url 解析为本地文件路径，或下载到 temp 返回路径 */
async function resolveVideoToLocalPath(videoUrl, baseUrl, storageRoot, tempDir, index, log) {
  if (!videoUrl || typeof videoUrl !== 'string') return null;
  const u = videoUrl.trim();
  if (baseUrl && (u.startsWith(baseUrl) || u.startsWith(baseUrl.replace(/\/$/, '')))) {
    const base = baseUrl.replace(/\/$/, '');
    const rel = u.startsWith(base + '/') ? u.slice(base.length + 1) : u.slice(base.length).replace(/^\//, '');
    if (rel && !rel.startsWith('http')) {
      const localPath = path.join(storageRoot, rel.replace(/\//g, path.sep));
      if (fs.existsSync(localPath)) return localPath;
    }
  }
  if (path.isAbsolute(u) && fs.existsSync(u)) return u;
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    const localPath = path.join(storageRoot, u.replace(/^\//, '').replace(/\//g, path.sep));
    if (fs.existsSync(localPath)) return localPath;
  }
  const ext = u.includes('.mp4') ? '.mp4' : u.includes('.webm') ? '.webm' : '.mp4';
  const destPath = path.join(tempDir, `dl_${Date.now()}_${index}${ext}`);
  try {
    const res = await fetch(u, { method: 'GET' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buf);
    return destPath;
  } catch (e) {
    log.warn('Video merge: download failed', { index, url: u, error: e.message });
    return null;
  }
}

/** * 核心合并函数：使用预转码后的标准片段进行合并
 */
function runFfmpegConcat(localPaths, outputPath, log = console) {
  const ffmpegBin = getFfmpegPath();
  const requestId = crypto.randomUUID().slice(0, 8);
  const listFile = path.join(path.dirname(outputPath), `concat_${requestId}.txt`);

  try {
    const lines = localPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(listFile, lines.join('\n'), 'utf8');

    log.info(`[${requestId}] 开始执行硬件加速/标准重编码合并...`);

    const args = [
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      // 视频编码优化：优先保证兼容性
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',

      // 音频容错逻辑：解决“合成后无声”的关键
      '-map', '0:v',            // 强制提取视频
      '-map', '0:a?',           // 【核心修复】可选音频映射：有则用，无则忽略，防止进程崩溃
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '44100',
      '-ac', '2',

      '-movflags', '+faststart',
      '-y',
      outputPath
    ];

    const result = spawnSync(ffmpegBin, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

    if (result.status !== 0) {
      log.error(`[${requestId}] FFmpeg 合并失败:`, result.stderr);
      return false;
    }
    return true;
  } catch (err) {
    log.error(`[${requestId}] 合并异常:`, err.message);
    return false;
  } finally {
    if (fs.existsSync(listFile)) try { fs.unlinkSync(listFile); } catch (e) { }
  }
}

/** 探测文件是否有视频流（非图片） */
function probeHasVideoStream(filePath, log) {
  const ffprobeBin = getFfmpegPath().replace(/ffmpeg$/, 'ffprobe').replace(/ffmpeg\.exe$/, 'ffprobe.exe');
  const res = spawnSync(ffprobeBin, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_type',
    '-of', 'csv=p=0',
    filePath
  ], { encoding: 'utf8' });
  return res.stdout && res.stdout.trim() === 'video';
}


/**
 * 异步处理视频合成：增加对豆包等 AI 视频的预处理（洗片）步骤
 */
async function processVideoMerge(db, log, mergeId, baseUrl) {
  const r = db.prepare('SELECT * FROM video_merges WHERE id = ? AND deleted_at IS NULL').get(mergeId);
  if (!r) return;

  const { task_id: taskId, episode_id: episodeId } = r;
  let scenes = [];
  try { scenes = JSON.parse(r.scenes || '[]'); } catch (_) { }

  db.prepare('UPDATE video_merges SET status = ? WHERE id = ?').run('processing', mergeId);
  const taskService = require('./taskService');

  if (scenes.length === 0) {
    db.prepare('UPDATE video_merges SET status = ?, error_msg = ? WHERE id = ?').run('failed', '无有效视频片段', mergeId);
    if (taskId) taskService.updateTaskError(db, taskId, '无有效视频片段');
    return;
  }

  const storageRoot = getStorageRoot();
  const tempDir = path.join(require('os').tmpdir(), 'drama-video-merge');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const toCleanup = [];
  const rawPaths = [];

  // 1. 下载或解析原始路径
  for (let i = 0; i < scenes.length; i++) {
    const p = await resolveVideoToLocalPath(scenes[i].video_url, baseUrl, storageRoot, tempDir, i, log);
    if (p) {
      rawPaths.push(p);
      if (p.startsWith(tempDir)) toCleanup.push(p);
    }
  }

  const totalDuration = scenes.reduce((sum, s) => sum + (Number(s.duration) || 0), 0);
  let mergedRelativePath = null;

  if (rawPaths.length > 0 && hasLocalFfmpeg()) {
    const sanitizedPaths = [];
    log.info(`开始预处理 ${rawPaths.length} 个视频片段...`);

    // 2. 核心预处理：将每个片段“洗”成标准的 H.264
    for (let i = 0; i < rawPaths.length; i++) {
      const input = rawPaths[i];
      const uuid = crypto.randomUUID().slice(0, 8);
      const output = path.join(tempDir, `std_${uuid}_${i}.mp4`);

      const ext = path.extname(input).toLowerCase();
      const isImage = ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext) || !probeHasVideoStream(input, log);

      let ffArgs;
      if (isImage) {
        // 图片转视频：自动补齐静音轨，防止合并时音频断流
        const duration = scenes[i]?.duration || 3;
        ffArgs = [
          '-loop', '1', '-t', duration.toString(), '-i', input,
          '-f', 'lavfi', '-i', 'anullsrc', // 虚拟音频源，解决 AI 视频音频不同步隐患
          '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30',
          '-c:a', 'aac', '-shortest', '-y', output
        ];
      } else {
        // 视频标准化：强制统一帧率与采样率，解决“前段有声后段无声”
        ffArgs = [
          '-i', input,
          '-c:v', 'libx264', '-preset', 'superfast',
          '-pix_fmt', 'yuv420p', '-vsync', 'cfr', '-r', '30',
          '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-y', output
        ];
      }

      const res = spawnSync(getFfmpegPath(), ffArgs);
      if (res.status === 0) {
        sanitizedPaths.push(output);
        toCleanup.push(output);
      } else {
        sanitizedPaths.push(input); // 退而求其次使用原片
      }
    }

    // 3. 执行合并
    const mergedDir = path.join(storageRoot, 'videos', 'merged');
    if (!fs.existsSync(mergedDir)) fs.mkdirSync(mergedDir, { recursive: true });
    const outputFileName = `merged_${Date.now()}.mp4`;
    const outputPath = path.join(mergedDir, outputFileName);

    const ok = runFfmpegConcat(sanitizedPaths, outputPath, log);
    if (ok && fs.existsSync(outputPath)) {
      mergedRelativePath = path.join('videos', 'merged', outputFileName).replace(/\\/g, '/');
      log.info('视频合并成功', { path: mergedRelativePath });
    }
  }

  // 清理所有临时文件
  for (const p of toCleanup) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { }
  }

  // 4. 更新数据库状态
  const fallbackUrl = (scenes[0] && scenes[0].video_url) || null;
  const finalMergedUrl = mergedRelativePath || fallbackUrl;
  const now = new Date().toISOString();

  db.prepare(
    'UPDATE video_merges SET status = ?, merged_url = ?, duration = ?, completed_at = ?, error_msg = ? WHERE id = ?'
  ).run('completed', finalMergedUrl, Math.round(totalDuration) || null, now, null, mergeId);

  db.prepare('UPDATE episodes SET video_url = ?, status = ?, updated_at = ? WHERE id = ?').run(finalMergedUrl, 'completed', now, episodeId);

  if (taskId) {
    taskService.updateTaskResult(db, taskId, { merge_id: mergeId, video_url: finalMergedUrl, duration: Math.round(totalDuration) });
  }
}

module.exports = {
  list,
  getById,
  create,
  deleteById,
  processVideoMerge,
};
