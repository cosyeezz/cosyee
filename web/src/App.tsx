// 阶段 D 由主会话接线。阶段 C 各 subagent 不要修改本文件。
// 调试自己的组件：新建 web/src/dev/<名字>.tsx（默认导出一个组件），打开 http://127.0.0.1:5173/?dev=<名字>
import { lazy, Suspense } from 'react';
import { MainApp } from './app/MainApp';

const devPages = import.meta.glob<{ default: React.ComponentType }>('./dev/*.tsx');

export function App() {
  const dev = new URLSearchParams(location.search).get('dev');
  if (dev) {
    const loader = devPages[`./dev/${dev}.tsx`];
    if (!loader) return <div style={{ padding: 24 }}>没有 dev 页：{dev}（可用：{Object.keys(devPages).join(', ')}）</div>;
    const Page = lazy(loader);
    return (
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    );
  }
  return <MainApp />;
}
