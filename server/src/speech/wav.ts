// 音频格式转换：合成结果（Float32）→ WAV；语音输入上传的 16 位 PCM → Float32。
// 只做单声道 16 位 PCM，所有浏览器 / WebView 的 <audio> 都能直接播，不需要 ffmpeg。

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt 块长度
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // 单声道
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // 每秒字节数
  buf.writeUInt16LE(2, 32); // 每帧字节数
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

/** 小端 16 位 PCM → [-1, 1) 浮点；奇数长度时丢掉最后一个字节 */
export function pcm16ToFloat32(buf: Buffer): Float32Array {
  const n = buf.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 0x8000;
  return out;
}
