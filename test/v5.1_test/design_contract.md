# Design Contract

## Objective
Create a deterministic filesystem artifact for solo test setup.

## Files
- `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test/`
  - Type: directory
  - Requirement: must exist.
- `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test/hello.txt`
  - Type: text file
  - Requirement: file content must be exactly `hello world`.
- `/Users/yzliu/work/Cord/test/v5.1_test/design_contract.md`
  - Type: text file
  - Requirement: defines this contract.

## Interfaces
- `DirectoryProvisioner.ensure(path)`
  - Input: absolute directory path
  - Behavior: create directory if missing; no-op if present
  - Deterministic output: directory exists at target path.
- `TextFileWriter.write_exact(path, content)`
  - Input: absolute file path, exact string
  - Behavior: overwrite file content with provided string
  - Deterministic output: file bytes match input string exactly.
- `Verifier.assert_exact(path, expected)`
  - Input: file path and expected text
  - Behavior: read file and compare exact value
  - Deterministic output: pass only if equal.

## Implementation Plan
1. Ensure directory exists at `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test`.
2. Write exact text `hello world` to `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test/hello.txt`.
3. Verify the file content is exactly `hello world`.
