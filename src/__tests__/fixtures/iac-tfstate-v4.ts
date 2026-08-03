// SPDX-License-Identifier: Apache-2.0

/** A realistic tfstate v4 fixture: drifted-comparable RDS instance, S3 bucket
 *  with a provider-v4 versioning sub-resource, DynamoDB table, one unwatchable
 *  ElastiCache cluster, plus data-mode and non-aws resources that parsers must skip.
 *  ARN account fields are deliberately empty — the pre-commit hook rejects
 *  12-digit account IDs in ARNs, and the parser only reads the region field. */
export const V4_STATE = JSON.stringify({
  version: 4,
  terraform_version: '1.9.0',
  serial: 42,
  lineage: 'abc',
  resources: [
    {
      mode: 'managed', type: 'aws_db_instance', name: 'main',
      provider: 'provider["registry.terraform.io/hashicorp/aws"]',
      instances: [{ attributes: {
        id: 'prod-db', arn: 'arn:aws:rds:us-east-1::db:prod-db',
        instance_class: 'db.t3.medium', engine: 'postgres', engine_version: '16',
        multi_az: false, backup_retention_period: 7, deletion_protection: true,
        storage_type: 'gp3', allocated_storage: 20,
      } }],
    },
    { mode: 'managed', type: 'aws_s3_bucket', name: 'uploads',
      instances: [{ attributes: { id: 'user-uploads', bucket: 'user-uploads', arn: 'arn:aws:s3:::user-uploads' } }] },
    { mode: 'managed', type: 'aws_s3_bucket_versioning', name: 'uploads',
      instances: [{ attributes: { id: 'user-uploads', bucket: 'user-uploads', versioning_configuration: [{ status: 'Enabled' }] } }] },
    { mode: 'managed', type: 'aws_dynamodb_table', name: 'sessions',
      instances: [{ attributes: {
        id: 'sessions', arn: 'arn:aws:dynamodb:us-east-1::table/sessions',
        billing_mode: 'PAY_PER_REQUEST', point_in_time_recovery: [{ enabled: true }],
      } }] },
    { mode: 'managed', type: 'aws_elasticache_cluster', name: 'cache',
      instances: [{ attributes: { id: 'app-cache', arn: 'arn:aws:elasticache:us-east-1::cluster:app-cache' } }] },
    { mode: 'data', type: 'aws_caller_identity', name: 'me', instances: [{ attributes: { id: 'x' } }] },
    { mode: 'managed', type: 'random_pet', name: 'suffix', instances: [{ attributes: { id: 'pet' } }] },
  ],
});
