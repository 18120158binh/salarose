output "rules" {
  description = "Each rule by its prefix: whether it is on, and after how many days it expires current and noncurrent objects."
  value = {
    for r in aws_s3_bucket_lifecycle_configuration.this.rule : r.filter[0].prefix => {
      enabled         = r.status == "Enabled"
      expiration_days = try(r.expiration[0].days, null)
      noncurrent_days = try(r.noncurrent_version_expiration[0].noncurrent_days, null)
    }
  }
}
