---
name: principle-inspect-resources-and-config
description: "Apply when an answer depends on how the code behaves once built and deployed. Read the packaged resources and configuration that reach the running program (bundled files, schemas, manifests, defaults, environment variables, deploy values) alongside the code."
disable-model-invocation: true
---

# Inspect Resources and Configuration

Code is half the program. The other half is what ships with it and what it is started with: bundled resource files, SQL schemas, migrations, manifests, default config files, environment variables, deploy values, feature flags, and the build settings that decide which of those get packaged. When they affect the question, read them alongside the code.

**Why:** A method that reads `metric.window.days` tells you nothing about the window until you find the value. Answers built from code alone describe a program that does not run anywhere.

- **Follow every value the code reads to its source.** A config key, an env var, a resource path, a table name: find where it is set, which default wins, and which file overrides it in the environment the question is about.
- **Check what the build actually packages.** A file in the source tree is not proof that it is in the artifact. Read the build file's resource includes and excludes, or list the built artifact.
- **Compare environments when the question is about one.** Local defaults, test config, and deploy values often differ. Name which one your answer holds for.
- **Treat the schema as code.** A column type, a constraint, a default, or a trigger can decide the behavior the code seems to own.

You skipped this when your answer names a config key, a resource, or a table, but not the value or the file that sets it.

Distinct from [Corroborate with the Right Evidence](../principle-corroborate-with-the-right-evidence/SKILL.md), which decides whether static reading is enough at all.
