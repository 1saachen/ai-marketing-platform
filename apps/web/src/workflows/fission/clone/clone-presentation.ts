export function cloneTime(milliseconds: number) {
  const seconds = Math.max(0, milliseconds) / 1000;
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toFixed(3).padStart(6, '0')}`;
}

export const cloneElementLabels = {
  product: '产品',
  person: '人物',
  scene: '场景',
  subtitle: '字幕',
  bgm: '背景音乐',
  voiceover: '口播',
} as const;

export const cloneObservationLabels = {
  OBSERVED: '已观察',
  NOT_DETECTED: '未检测到',
  UNASSESSED: '尚未分析',
  NOT_APPLICABLE: '不适用',
} as const;

export const cloneEvidenceLabels = {
  VISUAL: '画面观察',
  TRANSCRIPT: '转录依据',
  INFERENCE: '分析推断',
  UNASSESSED: '未核实',
} as const;
