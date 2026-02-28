# Design Contract

## Objective
Establish the deterministic test artifact requested by sole designer requirements: a dedicated directory plus a single text file with exact content under `/Users/yzliu/work/Cord/test/v5.1_test` so downstream automation can rely on fixed paths and payloads.

## Files
- `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test_1304/`
  - Type: directory.
  - Requirement: must exist with default perms and be empty except for the text file described below.
- `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test_1304/hello.txt`
  - Type: UTF-8 text file.
  - Requirement: contents must be exactly `hello world` followed by a single newline and nothing else.
- `/Users/yzliu/work/Cord/test/v5.1_test/design_contract.md`
  - Type: markdown document.
  - Requirement: defines this contract and any future updates should keep the Objective / Files / Interfaces / Implementation Plan sections synchronized with actual deliverables.

## Interfaces
- `DirectoryProvisioner.ensure(path)`
  - Input: absolute directory path.
  - Behavior: create the directory if it does not already exist; leave existing directories untouched.
  - Output: deterministic guarantee that the directory exists for subsequent steps.
- `TextFileWriter.write_exact(path, content)`
  - Input: absolute file path and exact string payload.
  - Behavior: create or truncate the file and write the payload with UTF-8 encoding in one atomic write if possible.
  - Output: deterministic guarantee that the file bytes match the provided string exactly.
- `Verifier.assert_exact(path, expected)`
  - Input: absolute path and expected text.
  - Behavior: read the file and fail (log and halt) if the contents differ.
  - Output: deterministic confirmation that the deployed artifact matches the design.

## Implementation Plan
1. Confirm the repository root and that `/Users/yzliu/work/Cord/test/v5.1_test` is writable.
2. Create `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test_1304` if it does not already exist, preserving its state otherwise.
3. Use `TextFileWriter.write_exact` or equivalent tool to write `hello world` plus newline into `v5.1_solo_test_1304/hello.txt`, overwriting any prior content.
4. Invoke `Verifier.assert_exact` against `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test_1304/hello.txt` to ensure the literal content is correct.
5. Leave the workspace in a deterministic state with no additional files created; report completion for tracking.
