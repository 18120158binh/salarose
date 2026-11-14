variable "bucket" {
  description = "The bucket that holds the drop zone under imports/."
  type        = string
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = var.bucket

  # DIM-NFR-01.
  rule {
    id     = "imports-incoming-30d"
    status = "Enabled"
    filter {
      prefix = "imports/incoming/"
    }
    expiration {
      days = 30
    }
  }

  # DIM-NFR-01.
  rule {
    id     = "imports-rejects-14d"
    status = "Enabled"
    filter {
      prefix = "imports/rejects/"
    }
    expiration {
      days = 14
    }
  }

  # The bucket is unversioned. If versioning is ever turned on, an overwritten or deleted upload must not linger as a
  # noncurrent version, and an abandoned multipart upload must not hold storage either.
  rule {
    id     = "imports-noncurrent-1d"
    status = "Enabled"
    filter {
      prefix = "imports/"
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
