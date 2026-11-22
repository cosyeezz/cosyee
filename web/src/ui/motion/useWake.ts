// 数据唤醒：数据从无到有的那一刻返回 true，持续一小段时间后自动回到 false。
// 期间组件加上 is-waking 类，CSS 负责依次出场、条形擦出、折线描出；结束后去掉类，界面保持静止。
import { useEffect, useState } from 'react';
import { motionOK } from './reduced';

export function useWake(ready: boolean, ms = 1600): boolean {
  const [prev, setPrev] = useState(false);
  const [waking, setWaking] = useState(false);
  // 渲染期比较上一次的值（React 推荐的「随 props 调整 state」写法），第一帧就带上类，不会先闪一下终态
  if (ready !== prev) {
    setPrev(ready);
    setWaking(ready && motionOK());
  }
  useEffect(() => {
    if (!waking) return;
    const t = window.setTimeout(() => setWaking(false), ms);
    return () => window.clearTimeout(t);
  }, [waking, ms]);
  return waking;
}
