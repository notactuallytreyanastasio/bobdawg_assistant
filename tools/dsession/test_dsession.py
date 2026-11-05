#!/usr/bin/env python3
"""Tests for dsession. Run with: python3 -m unittest test_dsession  (stdlib only)

These cover the transcript parser and the recording writer, the two parts whose
failure would be silent: a parser that stops matching markers produces a short
recording that still plays, and a writer with the wrong delay semantics produces
a recording that runs at the wrong speed.
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dsession as ds

LT, GT = chr(60), chr(62)
IM_START = LT + "|im_start|" + GT
IM_END = LT + "|im_end|" + GT


def msg(role, body):
    return IM_START + role + "\n" + body + IM_END + "\n"


class Transcript(unittest.TestCase):
    def test_split_messages_keeps_roles_and_bodies(self):
        text = msg("system", "instructions") + msg("user", "build a thing")
        msgs = ds.split_messages(text)
        self.assertEqual([m[0] for m in msgs], ["system", "user"])
        self.assertEqual(msgs[1][1].strip(), "build a thing")

    def test_carve_assistant_separates_thinking_prose_and_calls(self):
        call = (LT + "tool" + "_call" + GT + "\n" + LT + "function=bash" + GT + "\n"
                + LT + "parameter=command" + GT + "npm test\n"
                + LT + "/parameter" + GT + "\n"
                + LT + "/tool" + "_call" + GT)
        body = (LT + "think" + GT + "plan the fix" + LT + "/think" + GT
                + "the test says what I expected. " + call)
        thinks, prose, calls = ds.carve_assistant(body)
        self.assertEqual(thinks, ["plan the fix"])
        self.assertEqual(prose, "the test says what I expected.")
        self.assertEqual(calls, [("bash", {"command": "npm test"})])

    def test_events_separate_prompt_result_and_compaction(self):
        text = (msg("user", "the compacted earlier conversation summary")
                + msg("user", "what happened")
                + msg("user", LT + "tool" + "_response" + GT + "all green"))
        path = tempfile.mktemp()
        with open(path, "w") as fh:
            fh.write(text)
        kinds = [e["kind"] for e in ds.events_from(path)]
        os.remove(path)
        self.assertEqual(kinds, ["compaction", "prompt", "prompt", "result"])

    def test_parse_time_accepts_fractional_seconds(self):
        self.assertIsNotNone(ds.parse_time("2026-11-05T17:52:49.434044Z"))
        self.assertIsNone(ds.parse_time(None))


class Graph(unittest.TestCase):
    def test_decision_card_shows_its_rejected_option(self):
        nodes = [{"node_type": "decision", "title": "Chose the reader",
                  "description": "because it works today",
                  "created_at": "2026-11-05T16:00:00Z",
                  "rejected": ["Instrument the harness"]}]
        cards = ds.graph_cards(nodes)
        self.assertEqual(len(cards), 1)
        self.assertTrue(any(l.startswith("- rejected: Instrument")
                            for l in cards[0]["lines"]))

    def test_option_nodes_are_not_cards(self):
        cards = ds.graph_cards([{"node_type": "option", "title": "a rejected idea",
                                 "created_at": "2026-11-05T16:00:00Z"}])
        self.assertEqual(cards, [])


class Recording(unittest.TestCase):
    def nodes(self):
        return [
            {"node_type": "goal", "title": "goal one", "description": "",
             "created_at": "2026-11-05T16:00:00Z", "rejected": []},
            {"node_type": "decision", "title": "decision one",
             "description": "why it won", "created_at": "2026-11-05T16:30:00Z",
             "rejected": ["the other way"]},
            {"node_type": "outcome", "title": "seventy-five tests pass",
             "description": "", "created_at": "2026-11-05T17:00:00Z", "rejected": []},
        ]

    def test_compose_starts_with_the_intro_and_ends_with_the_tail(self):
        scenes = ds.compose([], self.nodes(), "abc1234567890", "ds4", "main")
        self.assertIn("a recording of the session", scenes[0]["text"])
        self.assertIn("end", scenes[-1]["text"])
        self.assertGreater(len(scenes), len(self.nodes()))
        # the tail counts the recording it is about to finish, not the scenes so far
        self.assertIn(f"{len(scenes)} scenes,", scenes[-1]["text"])

    def test_delays_stay_inside_the_floor_and_ceiling(self):
        scenes = ds.compose([], self.nodes(), "abc1234567890", "ds4", "main")
        for sc in scenes:
            self.assertGreater(sc["delay"], 0)
            self.assertLessEqual(sc["delay"], 5.0)

    def test_recording_is_asciicast_v2_with_relative_delays(self):
        scenes = ds.compose([], self.nodes(), "abc1234567890", "ds4", "main")
        path = tempfile.mktemp()
        total = ds.write_cast(scenes, path, "test")
        with open(path) as fh:
            header = json.loads(fh.readline())
            events = [json.loads(l) for l in fh]
        os.remove(path)
        self.assertEqual(header["version"], 2)
        self.assertEqual(header["width"], ds.WIDTH)
        self.assertTrue(all(e[1] == "o" for e in events))
        # v2 stores the delay since the previous event, and the sum is the runtime
        self.assertAlmostEqual(sum(e[0] for e in events), total, places=4)
        self.assertEqual(len(events), len(scenes))
        self.assertEqual(events[0][2], scenes[0]["text"])

    def test_render_shows_every_frame_in_order(self):
        scenes = ds.compose([], self.nodes(), "abc1234567890", "ds4", "main")
        path = tempfile.mktemp()
        ds.write_cast(scenes, path, "title")
        text = ds.render(path)
        os.remove(path)
        self.assertIn("title", text)
        self.assertIn("goal one", text)
        self.assertLess(text.index("goal one"), text.index("seventy-five tests pass"))


if __name__ == "__main__":
    unittest.main()
