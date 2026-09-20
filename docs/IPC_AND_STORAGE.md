# IPC与存储合同补充

本文件补足主规范中的输入输出，不是HTTP服务设计。所有写操作都需要工作区边界、预期版本、幂等键和发送者校验。原生文件对话框生成的句柄不得伪装为任意路径。

## 请求与响应

请求固定字段：schema_version、request_id、workspace_id（应用全局操作为null）、operation、expected_revision（无旧版本操作为null）、idempotency_key（纯读为null）、payload。响应固定字段：request_id、ok、data、error；ok=true时error=null，ok=false时data=null。分页统一limit（1—100）、cursor（null或由服务生成），不得由界面拼接SQL。

| 方法组 | payload必须字段 | 成功结果必须字段 |
|---|---|---|
| app.bootstrap/getStatus | 无／workspace_id | app_version、schema_version、workspace_summaries、provider_status、pending_recovery |
| settings.get/update | key／patch、expected_revision | settings、revision；不含原始密钥 |
| sources.pick | purpose、accepted_types | picker_token、display_name、mime、size_bytes；token绑定窗口与用途 |
| sources.import | picker_token、source_class、license_declaration、workspace_id | import_job_id、source_document_id、status |
| sources.search | query、filters、limit、cursor | items[{anchor_id,source_version_id,title,excerpt,verification}]、next_cursor |
| sources.read | source_version_id、locator、max_chars | source_anchor或安全本地preview_token |
| sources.retire | document_id、reason、confirmation_token | event_id、affected_revision_ids |
| curriculum.list | grade、semester、textbook_version_id | nodes、coverage_state、missing_sources |
| curriculum.importCoverage | resource_pack_token、license_declaration | job_id、manifest_hash、coverage_preview |
| plans.create | TaskContext、selected_source_version_ids | plan_id、job_id |
| plans.get/list | plan_id/revision_id或分页条件 | LessonPlan或列表；历史状态分离 |
| plans.revise | plan_id、base_revision_id、change_kind、change_payload | new_revision_id/job_id、invalidated_modules |
| plans.adopt | plan_id、revision_id、critical_review_ack | adoption_id；不生成teaching_event |
| plans.recordTeaching | revision_id、taught_at、confirmation_source、actual_conditions | teaching_event_id；不生成学习效果 |
| jobs.get/cancel/resume | job_id、reason或resume_policy | JobView、stage_summaries、uncertain_requests、cost_summary |
| observations.add/list | Observation或revision_id分页 | observation_id或受限摘要；敏感正文仅本地 |
| artifacts.render | plan_id、revision_id、formats、template_version | job_id、manifest_id |
| artifacts.export | artifact_id、save_dialog_token | exported_path_label、hash、bytes；路径由主进程决定 |
| artifacts.reveal | artifact_id | revealed=true，仅能定位登记的成果 |
| backup.create | workspace_id、mode、save_dialog_token、secret_input_token | backup_job_id；口令不进入日志或业务工作流 |
| backup.restore | picker_token、secret_input_token、confirmation_token | restore_job_id、target_snapshot、recovery_available |
| updates.check/stage/apply | channel／package_id／confirmation_token | verified_metadata、update_job_id或restart_scheduled |
| diagnostics.export | include_flags、save_dialog_token | manifest、redaction_summary、file_hash |
| provider.configure | endpoint、model_id、credential_input_token、budget_policy | profile_id、masked_credential、status |
| provider.probe | profile_id、cost_confirmation | capabilities、request_ids、measured_at、failures |
| provider.clear | profile_id、confirmation_token | credential_removed=true、pending_requests_status |

凭据输入框位于受控设置界面，通过单次安全路径送主进程；界面输入后立即清空，禁止持久化到localStorage、崩溃报告和状态快照。认证结果不得把原始Authorization头回传。

## 数据语义与SQL范围

storage-baseline.sql包含可执行初始化表结构，但并非完整应用迁移代码。实现者必须生成编号迁移、迁移校验、备份恢复和真实仓库层测试。JSON列内容仍需本包Schema与语义验证，不能依赖json_valid判断业务正确。

源文档重新分类为student_sensitive时，禁止简单更新classification；必须使用受控加密与索引清理事务，验证明文、FTS和缓存均被移除，然后切换分类。若迁移失败保持隔离状态。现有SQL触发器是第二道保护，不能替代此服务流程。

敏感观察正文在observations.payload_cipher，coverage_json只能含计数、提示状态和非识别任务条件，不能含姓名、学号、原始作文或完整班主任谈话。计划正文也不得混入学生原件；未授权的私人备注必须使用单独加密载荷引用，不落公开Plan正文。

引用跨度采用Unicode字符序号规范，由实现统一为code point，而不是混用JavaScript UTF-16下标；原文保存归一化副本与原始哈希，标准化标点不篡改教材引文。char_end为开区间；start≤end，quote必须匹配对应跨度。外部多字节位置必须通过显式映射。

事件只存内部对象ID、非敏感动作和版本。业务数据与outbox事件同事务写入；投影可重建，不让“写入事件成功而计划未更新”的状态被当作已完成。

## 必须实现的语义校验

所有ID引用存在且属同一工作区；任务引用的Rubric存在；每个需要独立表现的目标至少有一项independent任务；SourceAnchor属于已确认可用版本；official_exam评分存在可定位正式来源；所有selected活动end≥start且在实际课长内；并行活动的教师注意力冲突被发现；联结陌生材料具备支持或被移到教师背景；外发白名单不含学生敏感内容；任何状态改变不得由模型直接写数据库。

时间预算使用选中活动区间及实际分支，不能简单对所有并行条目求和。包内示例semantic_invalid同时含超时和缺失引用，必须被拒绝，尽管它满足基础JSON形状。


## 补充：设置与删除必须有明确接口

这些接口与前述统一封装、权限、幂等与版本规则相同。新建对象使用明确的新建语义，不伪造旧版本。

|操作|最小payload|结果与关键规则|
|---|---|---|
|workspaces.list|{}|工作区列表，不含敏感正文；只列本机当前用户获权工作区|
|workspaces.create|label|新Workspace及默认未确认设置；显式新建无expected_revision；不复制API密钥|
|workspaces.select|target_workspace_id|当前工作区摘要与刷新版本；验证归属；取消或保存旧工作区活动任务|
|classes.list|{}|当前工作区班级列表；不能跨工作区混读|
|classes.create|label,grade,duration_sec|null,duration_confirmed,timezone|新ClassProfile；新建语义；未确认课长保持未知|
|classes.update|class_id,patch|更新后ClassProfile版本及受影响计划摘要；expected_revision；改教材/课长使相关计划失效|
|sources.reclassify|source_document_id,new_classification,cloud_policy,confirmation_token|重分类状态、清理和派生引用失效摘要；敏感升级先收窄权限；加密清除明文事务和恢复保证|
|sources.delete|source_document_id,scope,confirmation_token|删除范围及备份残留说明；主进程明确确认token；原文、派生物、缓存按政策清理|
|observations.delete|observation_id,confirmation_token|删除摘要及未覆盖备份范围；主进程确认；删除敏感载荷并保留无正文墓碑|
|backups.list|{}|已完成可验证备份列表；不把临时文件列为可用；只返回受控句柄|
|backups.delete|backup_id,confirmation_token|删除摘要；主进程确认；不能自动删最后可用备份|
|plans.archive|plan_id,archived|归档状态和历史保留说明；expected_revision；不等同删除或效果确认|
