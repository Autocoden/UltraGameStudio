import { describe, expect, it } from 'vitest';
import { collectTurnArtifacts } from './turnArtifacts';

describe('会话交付物', () => {
  it('识别截图原始链接、Word 和脚本，去掉源码与重复路径', () => {
    const text = '[源码](/E:/Game/src/main.cpp:32)\n[查看截图对照](/E:/Game/.ultragamestudio/temp/compare.png)\n[下载完整 Word 报告](/E:/Game/reports/报告.docx)\n[同一报告](file:///E:/Game/reports/报告.docx)\n[生成脚本](scripts/fetch.mjs)';
    const artifacts = collectTurnArtifacts(text, 'E:/Game');
    expect(artifacts.map((item) => item.ref.path)).toEqual(['E:/Game/.ultragamestudio/temp/compare.png', 'E:/Game/reports/报告.docx', 'scripts/fetch.mjs']);
    expect(artifacts[1].label).toBe('下载完整 Word 报告');
    expect(collectTurnArtifacts(JSON.parse(JSON.stringify(text)), 'E:/Game')).toEqual(artifacts);
  });
  it('不会把推理、工具日志、代码例子和网络链接当成本地产物', () => {
    const text = '<think>[旧报告](E:/old.docx)</think>\n```markdown\n[例子](E:/example.docx)\n```\n[网页](https://example.com/report.docx)\n`src/test.ts`';
    expect(collectTurnArtifacts(text)).toEqual([]);
  });
  it('识别带空格路径、引用链接和文档目录裸路径', () => {
    const text = '[打开报告][report]\n\n[report]: </E:/Game/reports/MDSC report.docx>\n\n`E:/Game/.ultragamestudio/docs/dev/总结.md`';
    expect(collectTurnArtifacts(text).map((item) => item.ref.basename)).toEqual(['MDSC report.docx', '总结.md']);
  });
});
