# Design Contract

## Objective
Document and enforce deterministic artifact creation for solo designer tasks: a named folder plus a single text file with precise content under `/Users/yzliu/work/Cord/test/v5.1_test` so downstream processes can depend on the structure.

## Files
- `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test_1347/`
  - Type: directory
  - Requirement: ensure existence; only `hello.txt` should live inside unless future requirements specify additions.
- `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test_1347/hello.txt`
  - Type: UTF-8 text file
  - Requirement: contents must be exactly `hello world` with one newline at the end and no extra whitespace.
- `/Users/yzliu/work/Cord/test/v5.1_test/design_contract.md`
  - Type: Markdown file
  - Requirement: describe the current deliverables, interfaces, and implementation plan; update this contract whenever files or interfaces change.

## Interfaces
- `DirectoryProvisioner.ensure(path)`
  - Input: absolute directory path
  - Behavior: idempotently create the directory if missing
  - Output: directory exists, ready for files
- `TextFileWriter.write_exact(path, payload)`
  - Input: file path, exact string payload
  - Behavior: atomically overwrite the file with the payload using UTF-8 encoding
  - Output: file bytes equal the provided payload
- `Verifier.assert_exact(path, expected)`
  - Input: path and expected string
  - Behavior: read file and fail if contents differ
  - Output: deterministic confirmation before handing off the workspace

## Implementation Plan
1. Confirm repository path `/Users/yzliu/work/Cord/test/v5.1_test` is writable.
2. Invoke `DirectoryProvisioner.ensure` for `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test_1347`.
3. Invoke `TextFileWriter.write_exact` on `v5.1_solo_test_1347/hello.txt` to set the single-line payload `hello world` plus newline.
4. Use `Verifier.assert_exact` to check that `hello.txt` contains the expected string and no extras.
5. Keep workspace restricted to required files and note completion in `design_contract.md`.
