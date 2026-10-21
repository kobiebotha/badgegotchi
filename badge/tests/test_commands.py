"""Durable commands, terminal receipts, checkpoint retention and account UI."""
import copy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/"app"/"badgegotchi"))
from badgegotchi_commands import CommandQueue, validate_commands
from badgegotchi_state import AppState
from badgegotchi_view import AppView
from test_pairing import Memory, Entropy, IDENTITY
import test_pairing


class CommandQueueTests(unittest.TestCase):
    def setUp(self):
        self.entropy = Entropy()
        self.memory = Memory({"version":1,"owner_id":"owner","device_id":"device","commands":[],"awaiting":[],"notice":""})
        self.queue = CommandQueue(IDENTITY, self.entropy, self.memory)

    def receipt(self, command, state="accepted"):
        return {"state":state,"command_id":command["id"],"revision":"1","timer":{}}

    def test_accepted_command_survives_restart_until_covering_checkpoint(self):
        command = self.queue.append("hydration",1792526000)
        self.assertEqual(self.queue.capture(),command)
        self.queue.accepted(self.receipt(command))
        self.assertEqual((self.queue.count,self.queue.pending_count),(0,1))
        reopened = CommandQueue(IDENTITY,self.entropy,self.memory)
        self.assertEqual(reopened.optimistic,[command])
        reopened.checkpoint()
        self.assertEqual(reopened.pending_count,0)

    def test_rejected_receipt_removes_only_exact_command_and_records_notice(self):
        first = self.queue.append("pet",1792526000,pet_session_id="11111111-1111-4111-8111-111111111111")
        second = self.queue.append("hydration",1792526001)
        self.queue.accepted(self.receipt(first,"rejected"))
        self.assertEqual(self.queue.capture(),second)
        self.assertEqual(self.queue.optimistic,[second])
        self.assertTrue(self.queue.notice)

    def test_mismatched_receipt_and_failed_persistence_retain_authority(self):
        command = self.queue.append("hydration",1792526000)
        before = copy.deepcopy(self.queue.record)
        bad = dict(self.receipt(command),command_id="other")
        with self.assertRaises(ValueError): self.queue.accepted(bad)
        self.assertEqual(self.queue.record,before)
        self.memory.fail = True
        with self.assertRaises(OSError): self.queue.accepted(self.receipt(command))
        self.assertEqual(self.queue.record,before)
        with self.assertRaises(OSError): self.queue.append("movement",1792526001)
        self.assertEqual(self.queue.record,before)

    def test_capacity_includes_accepted_awaiting_and_owner_is_pinned(self):
        for i in range(16):
            command=self.queue.append("hydration",1792526000+i)
            self.queue.accepted(self.receipt(command))
        with self.assertRaisesRegex(ValueError,"queue full"): self.queue.append("movement",1792526020)
        with self.assertRaisesRegex(ValueError,"Another account"):
            CommandQueue(dict(IDENTITY,owner_id="other"),self.entropy,self.memory)
        self.assertEqual(self.queue.pending_count,16)

    def test_exact_big_revision_and_unset_clock(self):
        command=self.queue.append("timer_pause",1792526000,session_id="11111111-1111-4111-8111-111111111111",expected_revision="9007199254740993")
        self.assertEqual(command["expected_revision"],"9007199254740993")
        with self.assertRaises(ValueError): self.queue.append("hydration",None)
        with self.assertRaises(ValueError):
            self.queue.append("timer_pause",1792526000,session_id=command["session_id"],expected_revision=9007199254740993)


class CommandSupervisorTests(test_pairing.SyncTests):
    def setUp(self):
        super().setUp()
        memory=Memory({"version":1,"owner_id":"owner","device_id":"device","commands":[],"awaiting":[],"notice":""})
        self.commands=CommandQueue(IDENTITY,Entropy(),memory)
        self.sync.commands=self.commands

    def test_new_command_receipt_waits_for_actual_checkpoint_and_retries_stable_id(self):
        command=self.commands.append("hydration",1792526000)
        token=copy.deepcopy(self.gateway.responses[0])
        self.sync.step()
        self.assertEqual(self.sync.phase,"command")
        self.gateway.responses=[OSError("reply lost")]
        self.sync.step()
        self.assertEqual(self.commands.capture(),command)
        self.gateway.responses=[token,{"state":"accepted","command_id":command["id"],"revision":"0","timer":{}}]
        self.sync.step(2000); self.sync.step()
        self.assertEqual(self.gateway.calls[-1]["command"],command)
        self.assertEqual(self.commands.pending_count,1)
        self.assertFalse(self.sync.synced)
        for _ in range(3): self.sync.step()
        self.assertEqual(self.sync.phase,"stream")
        self.sync._instructions([{"DidCompleteSync":{"applied_checkpoint_request_id":"2"}}])
        self.assertEqual(self.commands.pending_count,1)
        self.sync.step()
        self.assertTrue(self.sync.synced)
        self.assertEqual(self.commands.pending_count,0)


class ViewTests(unittest.TestCase):
    def view(self):
        view=AppView.__new__(AppView)
        view.screen=SimpleNamespace(measure_text=lambda text,scale:(len(text)*6,10))
        return view

    def test_long_server_words_and_names_are_measured_and_bounded(self):
        view=self.view()
        for message in ("W"*160,"word "+"x"*200+" end","こんにちは"*40):
            self.assertTrue(all(len(line)*6<=280 for line in view.wrap(message)))
        self.assertLessEqual(len(view.clip("W"*40,132))*6,132)

    def test_details_show_only_account_totals_and_pending_separately(self):
        view=self.view(); rendered=[]
        view.header=lambda *args:None;view.box=lambda *args:None
        view.text=lambda text,*args,**kwargs:rendered.append(text)
        view.ink=view.green=view.muted=view.paper=None
        state=AppState(clock=lambda:1792526000)
        state.refresh({"summary":{"day_key":"2026-10-20","hydration_count":3,"movement_count":2,"ended_focus_count":4,"ended_break_count":1,"pet_count":9}},[])
        view.details(SimpleNamespace(status="PENDING",state=state,pending_count=2))
        self.assertIn("Water 3",rendered)
        self.assertIn("Focus 4",rendered)
        self.assertIn("2 pending",rendered)
        self.assertFalse(any("local" in text.lower() or "before pairing" in text.lower() for text in rendered))


if __name__=="__main__":unittest.main()
