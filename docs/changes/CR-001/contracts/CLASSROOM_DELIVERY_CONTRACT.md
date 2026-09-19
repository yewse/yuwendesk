# CR-001 课堂材料交付合同：必须表达的信息

版本：1.0.0｜性质：业务与数据合同设计要求，不是已经接入应用的JSON Schema或接口实现。

## 1. 不破坏现有严格合同
现有LessonPlan.schema.json和ArtifactManifest.schema.json的V1.0要求additionalProperties=false。本次新增的受众、角色、呈现、整包完成度不能直接塞进去后仍声称兼容V1.0。
执行者应优先增加一个引用旧计划/manifest的伴随交付合同（例如ClassroomDeliverySpec、ClassroomBundle），或提出受控的版本升级与迁移。生成器、校验器、例子、IPC及读取路径必须一起处理；禁止简单放开任意字段或复制一套可能漂移的计划。
下面是应具备的语义字段，并不指定最终存储表、API命名或库实现。

## 2. 交付规格

| 信息 | 含义/约束 |
|---|---|
| delivery_spec_id / spec_version | 呈现规格身份及版本，不与语义revision混淆 |
| plan_id / revision_id | 指向唯一已保存教学语义版本 |
| required_outputs | 默认：classroom_pptx；student_docx；student_pdf；teacher_docx；teacher_pdf |
| role / audience | 角色分别为classroom_presentation、student_handout、teacher_guide；分发受众与投屏受众分开 |
| format / template_version | 文件格式和版式版本，不凭文件后缀猜角色 |
| omissions | 无省略时为空；省略含角色、理由、范围和实际确认/策略来源；错误和未实现不是合法理由 |
| classroom_conditions | 实际课长、投影、纸张、打印、课本可用条件；未知不可伪造 |
| content_projection | 白名单式受众内容选择；不把完整教师对象传到学生视图再CSS隐藏 |
| reveal_policy | 每段是初始呈现、示范、提示、课后/反馈揭示、教师专用中的哪类；与具体任务关联 |
| response_space | 讲义某任务需要行/表格/草图/修改区，尺度是待版式验证的设计参数 |
| mapping | 稳定任务/活动/来源/联结ID关联到PPT页或显示阶段、学生节/题、教师节/题 |
| layout_overrides | 纸张、字号、主题、板式及已确认例外；不得偷偷改变题意 |

计划的题意、标准、核心事实发生变化，要进入语义新版本；仅字体或分页改变，可以更新呈现规格与渲染身份而不假造新的学习内容。展示中压缩的提示语必须事先可核对且保留规范题干定位。

## 3. 交付成果记录

| 信息 | 含义/约束 |
|---|---|
| bundle_id / spec_id / plan_id / revision_id | 把一套文件与唯一计划和规格绑定 |
| artifact_manifest_ref | 引用真实输出清单和字节哈希；不放原始学生数据或API密钥 |
| role_format_results | 每种所需角色/格式分别记录not_started、generating、ready、failed、omitted_by_policy等状态 |
| completion_state | 尚未准备、准备中、部分完成、完整默认包、按已确认策略完成、失败、旧版；不以minItems=1判完整 |
| files | 文件身份、受众、路径句柄或受限相对路径、真实字节SHA256、生成时间；不接受模型任意系统路径 |
| location_map | 当前渲染后真实页号、显示阶段与稳定ID；缺失映射给原因；重排后重新计算 |
| QA_refs | 结构、内容、受众、渲染、编辑器与环境证据分别记录 |
| supersedes_bundle_id | 新旧版本关系；旧包保留，旧纸本不会自动变化 |
| package_distribution_class | full_teacher_bundle或student_only，不能凭中文文件名决定权限 |

## 4. 必须由实现与测试验证的语义不变量

1. 默认角色矩阵要求五个实际文件。三类成品并非三种文件扩展名。
2. 所有非省略文件同plan_id/revision_id/spec_id，内容与角色标签一致。
3. 同一正文/任务可以在不同载体有不同呈现，但不得改变事实、限制、要求或合理评分范围。
4. 来源、任务和联结ID必须能解析；学生没有材料访问条件时，不能只给一个失效页码。
5. 受众过滤发生在生成前；学生文件和视图不包含教师专用数据。
6. 课堂PPT中的后置答案不是加密；该文件不进入默认学生分发集合。
7. 整包成功只能在全部必需文件就绪和必须检查完成后产生；已有旧包不被失败导出破坏。
8. 同一任务的课堂时间仅计算一次；三种载体不能变成三份任务。
9. 文件哈希由实际字节计算，不能用计划哈希填充。
10. 仅布局修改与语义修改分开；外部手改文件不自动改变内部计划。
11. 软件验收状态、真实课堂适配、学习效果分开；NOT_RUN不可改成PASS来凑齐交付。
12. 新增合同检查不授予发布、联网费用、资料授权或阶段越权。
