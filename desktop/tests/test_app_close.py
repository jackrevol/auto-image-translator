from __future__ import annotations

from zip_translator.app import _can_request_review, _should_minimize_on_close


class WorkerStub:
    def __init__(self, alive: bool) -> None:
        self.alive = alive

    def is_alive(self) -> bool:
        return self.alive


def test_running_work_is_minimized_instead_of_closed() -> None:
    assert _should_minimize_on_close(WorkerStub(True))


def test_finished_work_allows_normal_close() -> None:
    assert not _should_minimize_on_close(WorkerStub(False))
    assert not _should_minimize_on_close(None)


def test_review_button_can_queue_while_zip_is_still_running() -> None:
    assert _can_request_review(
        [{"source": "zip", "state": "review"}],
        worker_running=True,
        source_exists=True,
        destination_exists=False,
    )


def test_already_queued_review_is_not_requested_twice() -> None:
    assert not _can_request_review(
        [{"source": "zip", "state": "review", "review_queued": True}],
        worker_running=True,
        source_exists=True,
        destination_exists=False,
    )
