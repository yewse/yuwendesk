-- YuwenDesk 1.0 normative initialization baseline.
-- Development agent executes in tests. Teachers never execute SQL/CLI.
-- NOT an application implementation or a completed migration engine.
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
CREATE TABLE workspaces(id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE class_profiles(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), label TEXT NOT NULL,
 grade INTEGER CHECK(grade BETWEEN 7 AND 9), duration_sec INTEGER CHECK(duration_sec>=300), duration_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(duration_confirmed IN(0,1)),
 timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai', profile_json TEXT NOT NULL CHECK(json_valid(profile_json)), revision INTEGER NOT NULL CHECK(revision>0));
CREATE TABLE settings(workspace_id TEXT NOT NULL REFERENCES workspaces(id), key TEXT NOT NULL, value_json TEXT NOT NULL CHECK(json_valid(value_json)),
 revision INTEGER NOT NULL, PRIMARY KEY(workspace_id,key));
CREATE TABLE source_documents(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), display_title TEXT NOT NULL,
 classification TEXT NOT NULL CHECK(classification IN('public_reference','licensed_reference','teacher_private','student_sensitive')),
 license_json TEXT NOT NULL CHECK(json_valid(license_json)), retired_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE source_versions(id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES source_documents(id), version_no INTEGER NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), managed_relpath TEXT NOT NULL, media_type TEXT NOT NULL,
 extraction_state TEXT NOT NULL CHECK(extraction_state IN('IMPORTED','EXTRACTED','METADATA_CONFIRMED','CHECKED_FOR_USE','REQUIRES_REVIEW','QUARANTINED','RETIRED')),
 sensitive INTEGER NOT NULL CHECK(sensitive IN(0,1)), cloud_allowed INTEGER NOT NULL DEFAULT 0 CHECK(cloud_allowed IN(0,1)),
 text_content TEXT, payload_cipher BLOB, crypto_json TEXT CHECK(crypto_json IS NULL OR json_valid(crypto_json)), metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
 created_at TEXT NOT NULL, UNIQUE(document_id,version_no), CHECK(sensitive=0 OR (cloud_allowed=0 AND text_content IS NULL AND payload_cipher IS NOT NULL)));
CREATE TRIGGER source_sensitive_insert BEFORE INSERT ON source_versions
 WHEN (SELECT classification FROM source_documents WHERE id=NEW.document_id)='student_sensitive' AND NEW.sensitive<>1
 BEGIN SELECT RAISE(ABORT,'student source must be encrypted and local only'); END;
CREATE TRIGGER source_sensitive_update BEFORE UPDATE ON source_versions
 WHEN (SELECT classification FROM source_documents WHERE id=NEW.document_id)='student_sensitive' AND (NEW.sensitive<>1 OR NEW.cloud_allowed<>0 OR NEW.text_content IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'student source cannot become cloud/plaintext'); END;
CREATE TABLE source_anchors(id TEXT PRIMARY KEY, source_version_id TEXT NOT NULL REFERENCES source_versions(id), locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
 quote TEXT NOT NULL, context_before TEXT NOT NULL DEFAULT '', context_after TEXT NOT NULL DEFAULT '', verification TEXT NOT NULL CHECK(verification IN('exact_checked','needs_review','conflict')));
CREATE TRIGGER anchors_no_sensitive BEFORE INSERT ON source_anchors WHEN (SELECT sensitive FROM source_versions WHERE id=NEW.source_version_id)=1
 BEGIN SELECT RAISE(ABORT,'sensitive plaintext anchors forbidden'); END;
CREATE TABLE search_chunks(id INTEGER PRIMARY KEY, anchor_id TEXT NOT NULL REFERENCES source_anchors(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), title TEXT NOT NULL, content TEXT NOT NULL);
CREATE VIRTUAL TABLE search_fts USING fts5(title,content,tokenize='trigram');
CREATE TRIGGER chunks_ai AFTER INSERT ON search_chunks BEGIN INSERT INTO search_fts(rowid,title,content) VALUES(NEW.id,NEW.title,NEW.content); END;
CREATE TRIGGER chunks_ad AFTER DELETE ON search_chunks BEGIN DELETE FROM search_fts WHERE rowid=OLD.id; END;
CREATE TRIGGER chunks_au AFTER UPDATE ON search_chunks BEGIN DELETE FROM search_fts WHERE rowid=OLD.id; INSERT INTO search_fts(rowid,title,content) VALUES(NEW.id,NEW.title,NEW.content); END;
CREATE TABLE curriculum_requirements(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), anchor_id TEXT REFERENCES source_anchors(id),
 requirement_json TEXT NOT NULL CHECK(json_valid(requirement_json)), mapping_state TEXT NOT NULL CHECK(mapping_state IN('mapped','needs_source_confirmation','enrichment')));
CREATE TABLE curriculum_nodes(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), parent_id TEXT REFERENCES curriculum_nodes(id),
 grade INTEGER NOT NULL CHECK(grade BETWEEN 7 AND 9), kind TEXT NOT NULL, node_json TEXT NOT NULL CHECK(json_valid(node_json)), source_version_id TEXT REFERENCES source_versions(id));
CREATE TABLE curriculum_mappings(requirement_id TEXT NOT NULL REFERENCES curriculum_requirements(id), node_id TEXT NOT NULL REFERENCES curriculum_nodes(id),
 mapping_json TEXT NOT NULL CHECK(json_valid(mapping_json)), PRIMARY KEY(requirement_id,node_id));
CREATE TABLE skill_versions(id TEXT PRIMARY KEY, skill_key TEXT NOT NULL, version TEXT NOT NULL, definition_json TEXT NOT NULL CHECK(json_valid(definition_json)),
 sha256 TEXT NOT NULL CHECK(length(sha256)=64), status TEXT NOT NULL CHECK(status IN('draft','active','retired')), UNIQUE(skill_key,version));
CREATE TABLE plans(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), class_id TEXT NOT NULL REFERENCES class_profiles(id),
 title TEXT NOT NULL, created_at TEXT NOT NULL, archived_at TEXT);
CREATE TABLE plan_revisions(id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), revision_no INTEGER NOT NULL, parent_revision_id TEXT REFERENCES plan_revisions(id),
 content_json TEXT NOT NULL CHECK(json_valid(content_json)), content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
 schema_version TEXT NOT NULL, review_state TEXT NOT NULL CHECK(review_state IN('draft','ready_for_review','needs_fix','blocked')), created_at TEXT NOT NULL,
 UNIQUE(plan_id,revision_no));
CREATE TRIGGER immutable_revision BEFORE UPDATE ON plan_revisions BEGIN SELECT RAISE(ABORT,'create a new revision instead'); END;
CREATE TABLE revision_sources(revision_id TEXT NOT NULL REFERENCES plan_revisions(id), source_version_id TEXT NOT NULL REFERENCES source_versions(id), PRIMARY KEY(revision_id,source_version_id));
CREATE TABLE link_cards(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES plan_revisions(id), link_json TEXT NOT NULL CHECK(json_valid(link_json)));
CREATE TABLE plan_adoptions(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES plan_revisions(id), adopted_at TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE);
CREATE TABLE teaching_events(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES plan_revisions(id), taught_at TEXT NOT NULL,
 confirmation_source TEXT NOT NULL CHECK(confirmation_source IN('teacher_confirmed','authorized_record')), actual_conditions_json TEXT NOT NULL CHECK(json_valid(actual_conditions_json)));
CREATE TABLE artifacts(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES plan_revisions(id), kind TEXT NOT NULL CHECK(kind IN('docx','pptx','pdf','html')),
 managed_relpath TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64), renderer_version TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('pending','validated','failed')), created_at TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), plan_id TEXT REFERENCES plans(id), state TEXT NOT NULL,
 context_json TEXT NOT NULL CHECK(json_valid(context_json)), revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
 max_cost_microusd INTEGER NOT NULL CHECK(max_cost_microusd>=0), spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK(spent_microusd>=0),
 reserved_microusd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_microusd>=0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE stage_runs(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), module_id TEXT NOT NULL, input_hash TEXT NOT NULL,
 attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3), skill_version_id TEXT REFERENCES skill_versions(id), status TEXT NOT NULL,
 output_json TEXT CHECK(output_json IS NULL OR json_valid(output_json)), output_hash TEXT, error_code TEXT, created_at TEXT NOT NULL,
 UNIQUE(job_id,module_id,input_hash,attempt_no));
CREATE TABLE provider_calls(id TEXT PRIMARY KEY, job_id TEXT REFERENCES jobs(id), stage_run_id TEXT REFERENCES stage_runs(id), provider_profile_id TEXT NOT NULL,
 model_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL, provider_request_id TEXT, status TEXT NOT NULL CHECK(status IN('reserved','sent','succeeded','failed','uncertain','cancelled')),
 input_tokens INTEGER, output_tokens INTEGER, billed_microusd INTEGER CHECK(billed_microusd>=0), price_version TEXT, created_at TEXT NOT NULL, settled_at TEXT);
CREATE TABLE cost_reservations(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), provider_call_id TEXT NOT NULL UNIQUE REFERENCES provider_calls(id),
 amount_microusd INTEGER NOT NULL CHECK(amount_microusd>=0), state TEXT NOT NULL CHECK(state IN('reserved','settled','released','uncertain')));
CREATE TABLE observations(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), revision_id TEXT NOT NULL REFERENCES plan_revisions(id),
 payload_cipher BLOB NOT NULL, crypto_json TEXT NOT NULL CHECK(json_valid(crypto_json)), coverage_json TEXT NOT NULL CHECK(json_valid(coverage_json)),
 cloud_allowed INTEGER NOT NULL DEFAULT 0 CHECK(cloud_allowed=0), created_at TEXT NOT NULL);
CREATE TABLE change_proposals(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES plan_revisions(id), proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
 state TEXT NOT NULL CHECK(state IN('proposed','accepted','rejected','reverted','supported_with_limits')), created_at TEXT NOT NULL);
CREATE TABLE review_reports(id TEXT PRIMARY KEY, revision_id TEXT NOT NULL REFERENCES plan_revisions(id), report_json TEXT NOT NULL CHECK(json_valid(report_json)), created_at TEXT NOT NULL);
CREATE TABLE consents(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), scope TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('granted','revoked')),
 policy_version TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE audit_events(id TEXT PRIMARY KEY, workspace_id TEXT REFERENCES workspaces(id), event_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
 metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)), occurred_at TEXT NOT NULL);
CREATE TRIGGER immutable_audit BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'append a correction event'); END;
CREATE TABLE outbox(id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES audit_events(id), state TEXT NOT NULL CHECK(state IN('pending','delivered','failed')), attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE idempotency_records(workspace_id TEXT NOT NULL, operation TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 response_json TEXT NOT NULL CHECK(json_valid(response_json)), created_at TEXT NOT NULL, PRIMARY KEY(workspace_id,operation,idempotency_key));
CREATE TABLE backups(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), managed_relpath TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 mode TEXT NOT NULL CHECK(mode IN('same_device','portable_encrypted')), state TEXT NOT NULL CHECK(state IN('pending','validated','failed')), created_at TEXT NOT NULL);
CREATE TABLE provider_profiles(id TEXT PRIMARY KEY, provider TEXT NOT NULL, endpoint TEXT NOT NULL, model_id TEXT NOT NULL, settings_json TEXT NOT NULL CHECK(json_valid(settings_json)),
 credential_ref TEXT, verified_at TEXT);
CREATE INDEX idx_sources_workspace ON source_documents(workspace_id,classification);
CREATE INDEX idx_versions_document ON source_versions(document_id,version_no);
CREATE INDEX idx_plans_workspace ON plans(workspace_id,created_at);
CREATE INDEX idx_stage_job ON stage_runs(job_id,status);
CREATE INDEX idx_events_aggregate ON audit_events(aggregate_id,occurred_at);
CREATE INDEX idx_artifacts_revision ON artifacts(revision_id,kind);

CREATE TRIGGER anchors_update_no_sensitive BEFORE UPDATE ON source_anchors
 WHEN (SELECT sensitive FROM source_versions WHERE id=NEW.source_version_id)=1
 BEGIN SELECT RAISE(ABORT,'sensitive plaintext anchors forbidden'); END;
CREATE TRIGGER reclassify_student_guard BEFORE UPDATE OF classification ON source_documents
 WHEN NEW.classification='student_sensitive' AND (
 EXISTS(SELECT 1 FROM source_versions WHERE document_id=NEW.id AND (sensitive<>1 OR cloud_allowed<>0 OR text_content IS NOT NULL OR payload_cipher IS NULL))
 OR EXISTS(SELECT 1 FROM source_anchors a JOIN source_versions v ON a.source_version_id=v.id WHERE v.document_id=NEW.id))
 BEGIN SELECT RAISE(ABORT,'clear plaintext anchors and encrypt all versions before student reclassification'); END;
