from __future__ import annotations

from format_guardrails import apply_guardrails


def test_apply_guardrails_adds_fence_when_requested() -> None:
    message = "请用代码块输出，多行代码"
    reply = "\n".join(
        [
            "Title",
            "def main():",
            "    print('ok')",
            "    return 0",
            "",
            "if __name__ == '__main__':",
            "    main()",
        ]
    )
    fixed = apply_guardrails(message, reply)
    assert "```" in fixed
    assert "def main()" in fixed


def test_apply_guardrails_repairs_unbalanced_fence() -> None:
    message = "请用代码块输出，多行代码"
    reply = "\n".join(
        [
            "Title",
            "```python",
            "def main():",
            "    print('ok')",
            "    return 0",
            "",
            "if __name__ == '__main__':",
            "    main()",
        ]
    )
    fixed = apply_guardrails(message, reply)
    assert fixed.count("```") % 2 == 0


def test_apply_guardrails_adds_missing_fences_outside_blocks() -> None:
    message = "请用代码块输出，多行代码"
    reply = "\n".join(
        [
            "Title A",
            "def one():",
            "    a = 1",
            "    b = 2",
            "    c = a + b",
            "    return c",
            "print(one())",
            "```js",
            "function two() {",
            "  return 2;",
            "}",
            "```",
            "",
            "Title B",
            "class Three:",
            "    def __init__(self):",
            "        self.value = 3",
            "    def get(self):",
            "        return self.value",
            "print(Three().get())",
        ]
    )
    fixed = apply_guardrails(message, reply)
    assert fixed.count("```") >= 4
