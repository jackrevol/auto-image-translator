from __future__ import annotations

from zip_translator.app import _natural_sort_key, _should_follow_new_row


def test_natural_sort_key_orders_image_numbers_naturally() -> None:
    names = ["page10.png", "page2.png", "page1.png"]

    assert sorted(names, key=_natural_sort_key) == ["page1.png", "page2.png", "page10.png"]


def test_progress_updates_do_not_force_scroll_to_existing_row() -> None:
    assert not _should_follow_new_row(item_exists=True, last_visible_fraction=1.0)
    assert not _should_follow_new_row(item_exists=False, last_visible_fraction=0.6)
    assert _should_follow_new_row(item_exists=False, last_visible_fraction=1.0)
