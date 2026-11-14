# Checks the drop zone's lifecycle rules against DIM-NFR-01 with a mocked provider, so no AWS credentials are needed.
# Run from this module: `terraform init && terraform test`.

mock_provider "aws" {}

variables {
  bucket = "test-bucket"
}

run "drop_zone_lifecycle" {
  command = plan

  assert {
    condition     = output.rules["imports/incoming/"].enabled && output.rules["imports/incoming/"].expiration_days == 30
    error_message = "imports/incoming/ must expire after 30 days (DIM-NFR-01)."
  }

  assert {
    condition     = output.rules["imports/rejects/"].enabled && output.rules["imports/rejects/"].expiration_days == 14
    error_message = "imports/rejects/ must expire after 14 days (DIM-NFR-01)."
  }

  assert {
    condition     = output.rules["imports/"].enabled && output.rules["imports/"].noncurrent_days == 1
    error_message = "Noncurrent versions under imports/ must expire after 1 day."
  }

  assert {
    condition = alltrue([
      for prefix, r in output.rules : r.expiration_days == null if startswith("imports/tombstones/", prefix)
    ])
    error_message = "No rule may expire current objects under imports/tombstones/."
  }
}
