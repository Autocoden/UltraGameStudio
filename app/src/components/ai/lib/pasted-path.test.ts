import { describe, expect, it } from 'vitest';
import { scanFileRefs } from './fileScan';
import { parseFileRef, isImageFileRef } from './filePath';

describe('pasted clipboard image path reproduction', () => {
  it('parses the exact pasted- path as a FileRef', () => {
    const p = 'E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1788857020264-c592421b9df12fd2-0.png';
    const ref = parseFileRef(p);
    expect(ref).not.toBeNull();
    expect(ref!.basename).toBe('pasted-1788857020264-c592421b9df12fd2-0.png');
    expect(isImageFileRef(ref!)).toBe(true);
  });

  it('parses the path inside backticks (as user pasted into composer)', () => {
    const text = '`E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1788857020264-c592421b9df12fd2-0.png`';
    const parts = scanFileRefs(text);
    console.log('parts:', JSON.stringify(parts, null, 2));
    const refs = parts.filter((p) => typeof p !== 'string');
    expect(refs.length).toBe(1);
  });

  it('parses the path inside backticks glued to Chinese prose', () => {
    const text = '另外这里好像能点击的：`E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1788857020264-c592421b9df12fd2-0.png`，其实也点击不了';
    const parts = scanFileRefs(text);
    console.log('parts:', JSON.stringify(parts, null, 2));
    const refs = parts.filter((p) => typeof p !== 'string');
    expect(refs.length).toBe(1);
  });

  it('parses the path glued to leading Chinese prose with no whitespace', () => {
    const text = '图片E:\\UltraGameStudio\\.ultragamestudio\\clipboard-images\\pasted-1788857020264-c592421b9df12fd2-0.png这样';
    const parts = scanFileRefs(text);
    console.log('parts:', JSON.stringify(parts, null, 2));
    const refs = parts.filter((p) => typeof p !== 'string');
    expect(refs.length).toBe(1);
  });
});
