import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    reporters: 'default',
    // 多个测试文件并行生成真实 PPTX/DOCX/PDF 时会竞争 CPU；保留逐项真实生成，不以 mock 换速度。
    testTimeout: 15_000
  }
});
