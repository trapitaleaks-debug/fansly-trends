# E3 backfill snapshot — 26.07.2026

All 49 rows below had `failure_kind = NULL` and `needs_review = false` before the backfill.
Rollback is a single statement:

```sql
update video_jobs set failure_kind = null, needs_review = false
where id in (
'33fdaf99-e3cb-48d5-a2b4-d1da305d423b','63ec4a41-9274-4c70-80aa-dd00ae6a770e','c6501d22-d632-4e04-b427-55d43f157aec',
'470746fb-966d-40c8-8735-8ca9977d4a5b','0f6f61d7-5aff-499a-ae75-5d2cacb5ffbf','473d785f-b054-445f-a055-cb50d130e58f',
'5bd8ac87-58b3-4ec1-9435-b1f9f1e1472d','b12bf60d-ae93-41ea-80a2-74ed90d189c5','35ab5c59-caa3-41a5-a662-0d32c70495d3',
'f3c5ac10-e7df-4dcc-80e6-fbe663bb914f','41506dc7-844b-4f1c-8d6e-0946bb6dd221','b301b131-b18b-4bdb-b095-70b300e8ac9a',
'db4e77c5-e495-4fee-a4c5-ed7136a58560','86f1d6a4-b031-4e07-909a-752efe6798a2','b70ba276-c699-4071-874a-1c9990a8485a',
'e10808b1-d91e-4d74-9be0-02c56f7381a4','de71e9e7-d1de-4c7c-8f77-df16aecc7a0e','416d8e4c-9d18-4a4b-ba6d-13cd4c3fcc57',
'fdd976d7-4ecb-4c31-ad98-0c2905edfc87','2fea1d4c-1a8b-444a-b795-189c659802a7','897188df-902d-48b2-845d-aa37edec5ad4',
'b95b103c-11a1-4dc6-8f9a-afecd7d30e2c','33a9dbc2-e004-4e4a-a1a3-cf07dd3849b6','f0f5b609-02d8-4f0e-921c-8381389403c3',
'be7110c9-bd4b-4984-96ea-ede20750afea','3901188a-31bf-4f16-8335-8b4192b00f33','fa48fa21-61b0-4061-be48-0c78b45ce243',
'4464e14f-83ee-4447-a5d1-56e7e5500431','abb806de-5c9f-44db-a9fc-6aa9ff876652','46d5dd35-0c90-402e-93c1-76cc4d4758b9',
'801b10c6-9e49-4322-b2ae-52ccdea9d0fc','774eae0a-d2c4-42df-993d-e9a6bab1fee3','ed9ccded-1ad6-44db-8cec-93bd01e1ade6',
'92eb085c-0604-4d6f-97ca-72a28d3d8f13','41e42c21-4c1f-454b-b3f8-2214943b2e74','364ab5de-c651-48eb-acdd-9fc00e872757',
'0ba2e66c-3423-4dec-869f-b31b697c3aa8','b5f076ba-c966-410b-a59d-560355185e9c','fafb4728-f34e-4e2b-a27b-4730f51325cc',
'c2ec0a02-7fc4-4160-b681-4c4c92aa2050','ace802b0-8db5-41ba-b7d6-4cbfa1bf04bc','cea08b0a-2608-4e2f-88ed-a17c12fa7c47',
'5f7ae7b5-a087-4ff2-a2da-4c6368801caf','aad2993e-0682-40f6-9cdb-d46532efdaac','73e37613-8676-4097-bfce-ea6822f68292',
'20e655c1-605b-4f39-ae03-44edf3628e7e','d301dd1a-4da1-46b6-ba52-13ef2dfd00ca','ae54782a-b4b6-4b22-88cf-2f27b12bbe1e',
'60110b0a-afbf-4557-9f72-5abfb9623296');
```

Applied: transcode_failed 19 · quarantined 16 · asset_missing 12 · render_hung 1 · verify_timeout 1.
`needs_review` set only on the non-retryable kinds (asset_missing, quarantined).
