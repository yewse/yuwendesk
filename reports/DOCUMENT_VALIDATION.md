# 文档与合同校验报告

这是工程文档包的检查，不是应用、安装包、真实Grok或教学效果测试。

## JSON文件语法｜PASS

29

## JSON Schema元模式｜PASS

11份通过结构检查

## 任务有效样例｜PASS

task_context.valid.json

## 计划有效样例｜PASS

lesson_plan.valid.json

## 未执行发行证据样例｜PASS

release_evidence.not_run.json

## 结构负例被拒绝｜PASS

故意无效枚举被拒绝：'all_students_mastered' is not one of ['unknown', 'initial_support', 'repeated_support']

## 语义负例结构可通过｜PASS

{'note': '样例故意符合Schema但违反语义，证明结构与业务检查不能混淆', 'differences': ['tasks', 'activities']}

## 需求覆盖与真实状态｜PASS

130条案例；60条原需求都有对应案例；全部应用测试保持NOT_RUN

## 工作包依赖｜PASS

48个工作包依赖无环且用例引用存在

## SQL基线语法及有限不变量｜PASS

SQLite 3.46.1内存执行；33张表（含FTS虚表，不含FTS内部表）；敏感明文、敏感锚点和原地改版本负例被拒绝。非桌面应用测试。

应用验收130项仍为NOT_RUN。没有编译EXE，没有Windows实测，也没有使用用户账户。
