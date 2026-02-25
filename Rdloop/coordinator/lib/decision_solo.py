#!/usr/bin/env python3
"""decision_solo.py — Deterministic decision logic for the solo coordinator loop.

Reads a coder response JSON (with self_eval, confidence, etc.) and emits a
deterministic next-action decision for the coordinator.

Usage:
    python3 decision_solo.py --response response.json --iteration 2 --max-iterations 5

Output (stdout, JSON):
    {"action": "CONTINUE", "reason": "self_eval=progress, iteration 2/5"}

Actions:
    CONTINUE         — coder should keep going (another iteration)
    READY_FOR_REVIEW — work is done, pass to judge or human review
    PAUSED           — needs human input or step-by-step approval
    ABORT            — dead loop detected, stop immediately

Exit codes:
    0 = decision emitted successfully
    1 = bad arguments or missing/invalid response file
"""
import argparse
import json
import sys

VALID_ACTIONS = {"CONTINUE", "READY_FOR_REVIEW", "PAUSED", "ABORT"}

VALID_SELF_EVALS = {
    "goal_met",
    "progress",
    "stuck",
    "dead_loop",
    "need_user_input",
}


def load_response(path):
    """Load and return the response JSON from *path*.

    Returns (data_dict, None) on success or (None, error_string) on failure.
    """
    try:
        with open(path, "r") as f:
            raw = f.read()
        data = json.loads(raw)
        return data, None
    except json.JSONDecodeError as e:
        return None, "invalid JSON in response file: %s" % str(e)
    except Exception as e:
        return None, "error reading response file: %s" % str(e)


def decide(response, iteration, max_iterations, approval_mode, auto_pass_threshold):
    """Return (action, reason) tuple based on deterministic rules.

    Decision priority (evaluated top-to-bottom, first match wins):
      1. self_eval == "dead_loop"             → ABORT
      2. self_eval == "need_user_input"        → PAUSED
      3. self_eval == "goal_met" and
         confidence >= auto_pass_threshold     → READY_FOR_REVIEW
      4. self_eval == "goal_met" and
         confidence <  auto_pass_threshold     → PAUSED (needs human review)
      5. iteration >= max_iterations           → READY_FOR_REVIEW (time limit)
      6. approval_mode == "step2step"          → PAUSED (wait for human)
      7. otherwise                             → CONTINUE
    """
    self_eval = response.get("self_eval", "progress")
    confidence = response.get("confidence", 0.0)

    # Normalise confidence to float
    if not isinstance(confidence, (int, float)):
        try:
            confidence = float(confidence)
        except (TypeError, ValueError):
            confidence = 0.0

    # --- Rule 1: dead loop ---------------------------------------------------
    if self_eval == "dead_loop":
        return "ABORT", "self_eval=dead_loop; aborting to prevent wasted iterations"

    # --- Rule 2: needs user input --------------------------------------------
    if self_eval == "need_user_input":
        questions = response.get("questions_for_user", [])
        q_summary = " (%d questions)" % len(questions) if questions else ""
        return "PAUSED", "self_eval=need_user_input%s; waiting for human" % q_summary

    # --- Rule 3: goal met + high confidence ----------------------------------
    if self_eval == "goal_met" and confidence >= auto_pass_threshold:
        return (
            "READY_FOR_REVIEW",
            "self_eval=goal_met, confidence=%.2f >= threshold=%.2f" % (
                confidence, auto_pass_threshold),
        )

    # --- Rule 4: goal met + low confidence -----------------------------------
    if self_eval == "goal_met" and confidence < auto_pass_threshold:
        return (
            "PAUSED",
            "self_eval=goal_met but confidence=%.2f < threshold=%.2f; needs human review" % (
                confidence, auto_pass_threshold),
        )

    # --- Rule 5: iteration limit ---------------------------------------------
    if iteration >= max_iterations:
        return (
            "READY_FOR_REVIEW",
            "iteration %d >= max_iterations %d; time limit reached" % (
                iteration, max_iterations),
        )

    # --- Rule 6: step-by-step approval mode ----------------------------------
    if approval_mode == "step2step":
        return (
            "PAUSED",
            "approval_mode=step2step; pausing for human review after iteration %d" % iteration,
        )

    # --- Rule 7: default — keep going ----------------------------------------
    return (
        "CONTINUE",
        "self_eval=%s, iteration %d/%d; continuing" % (
            self_eval, iteration, max_iterations),
    )


def build_parser():
    """Build and return the argument parser."""
    parser = argparse.ArgumentParser(
        description="Solo coordinator decision logic — deterministic next-action resolver.",
    )
    parser.add_argument(
        "--response", required=True,
        help="Path to the coder response JSON file",
    )
    parser.add_argument(
        "--iteration", type=int, required=True,
        help="Current iteration number (1-based)",
    )
    parser.add_argument(
        "--max-iterations", type=int, required=True,
        help="Maximum allowed iterations before forcing review",
    )
    parser.add_argument(
        "--approval-mode", default="agent_decides",
        choices=["agent_decides", "step2step"],
        help="Approval mode: agent_decides (default) or step2step",
    )
    parser.add_argument(
        "--auto-pass-threshold", type=float, default=0.8,
        help="Confidence threshold for auto-pass to review (default: 0.8)",
    )
    return parser


def main():
    parser = build_parser()
    args = parser.parse_args()

    # Validate iteration values
    if args.iteration < 1:
        sys.stderr.write("error: --iteration must be >= 1, got %d\n" % args.iteration)
        sys.exit(1)
    if args.max_iterations < 1:
        sys.stderr.write("error: --max-iterations must be >= 1, got %d\n" % args.max_iterations)
        sys.exit(1)
    if not (0.0 <= args.auto_pass_threshold <= 1.0):
        sys.stderr.write("error: --auto-pass-threshold must be in [0.0, 1.0], got %.4f\n" % args.auto_pass_threshold)
        sys.exit(1)

    # Load response
    response, err = load_response(args.response)
    if err:
        sys.stderr.write("error: %s\n" % err)
        sys.exit(1)

    # Decide
    action, reason = decide(
        response=response,
        iteration=args.iteration,
        max_iterations=args.max_iterations,
        approval_mode=args.approval_mode,
        auto_pass_threshold=args.auto_pass_threshold,
    )

    # Emit JSON to stdout
    result = {"action": action, "reason": reason}
    sys.stdout.write(json.dumps(result) + "\n")
    sys.exit(0)


if __name__ == "__main__":
    main()
