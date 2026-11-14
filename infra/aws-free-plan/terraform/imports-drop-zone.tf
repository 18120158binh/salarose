# The data import drop zone lives under imports/ in the private bucket (docs/internal/features/data-import.md).
# Shops upload to imports/incoming/ through presigned URLs only (DIM-NFR-03). Rejected files move to imports/rejects/,
# and erasure requests live under imports/tombstones/, which no rule expires. S3 prefixes need no creation.
#
# The module owns the bucket's whole lifecycle configuration: a rule for another prefix goes there too, or S3 drops it.
module "drop_zone_lifecycle" {
  source = "./modules/drop-zone-lifecycle"
  bucket = aws_s3_bucket.flink.id
}
