# Design Contract

## Scope
Establish a deterministic filesystem artifact set for the solo test target.

## Files
- `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test/`
  - Purpose: Dedicated folder for the v5.1 solo test artifact.
- `/Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test/hello.txt`
  - Purpose: Required text artifact.
  - Required content (exact): `hello world` followed by a trailing newline.
- `/Users/yzliu/work/Cord/test/v5.1_test/design_contract.md`
  - Purpose: This contract document.

## Interfaces
- Filesystem interface: directory creation
  - Operation: `mkdir -p /Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test`
  - Contract: Directory exists after execution.
- Filesystem interface: file write
  - Operation: write plain text to `hello.txt`
  - Contract: File exists and full content is exactly `hello world\n`.
- Verification interface: file read
  - Operation: `cat /Users/yzliu/work/Cord/test/v5.1_test/v5.1_solo_test/hello.txt`
  - Contract: Output line is `hello world`.

## Implementation Plan
1. Ensure the target directory exists.
2. Write `hello world` into `hello.txt` with a trailing newline.
3. Verify file existence and content by reading the file.
4. Keep contract and implementation deterministic by using absolute paths and exact string content.

## Acceptance Mapping
- Goal satisfied when:
  - `v5.1_solo_test` exists under `/Users/yzliu/work/Cord/test/v5.1_test/`.
  - `hello.txt` exists in that folder.
  - `hello.txt` content is exactly `hello world` (newline-terminated).
