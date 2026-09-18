import { useState } from 'react';
import { CoreScene } from './CoreScene';
import { DataViewDock } from './DataViewPanel';
import type { DataViewState } from '../lib/data-view';

export const PREVIEW_TASKS = {
  tasks: [
    { title: '市場調査レポートの収集', status: '未着手' },
    { title: '競合サービスの分析', status: '未着手' },
    { title: 'デザイン案の生成', status: '未着手' },
    { title: 'API仕様の調査', status: '未着手' },
    { title: 'LPのワイヤーフレーム作成', status: '進行中', progress: 1 },
    { title: 'データ分析とレポート作成', status: '進行中', progress: 0.6 },
    { title: 'プロトタイプの開発', status: '進行中', progress: 0.5 },
    { title: 'UIコンポーネントの設計', status: 'レビュー', progress: '2/3' },
    { title: 'テスト設計とケース作成', status: 'レビュー', progress: '2/3' },
    { title: '要件ヒアリングの整理', status: '完了', progress: 1 },
    { title: '技術調査の完了', status: '完了', progress: 1 },
    { title: 'キックオフ資料の作成', status: '完了', progress: 1 },
  ],
};

/** Development-only visual fixture for data views. */
export default function DataViewPreview() {
  const [views, setViews] = useState<DataViewState[]>(() => [{
    id: 'view-1', title: 'タスク', status: 'ready', updatedAt: Date.now(),
    data: PREVIEW_TASKS,
    spec: { title: 'タスク', subtitle: 'AIが自律的にタスクを実行しています', blocks: [
      { type: 'board', path: 'tasks', group: 'status', title: 'title', progress: 'progress', groups: ['未着手', '進行中', 'レビュー', '完了'] },
    ] },
  }]);
  return <div className="shell immersive-shell">
    <div className="scene-background" aria-hidden="true"><CoreScene level={0} active activity="idle" /></div>
    <DataViewDock views={views} onClose={id => setViews(current => current.filter(view => view.id !== id))} />
  </div>;
}
