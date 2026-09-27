from app.mod09 import value09, tag09, linked09


def test_value_subtracts():
    assert value09(11) == 2


def test_tag():
    assert tag09() == "mod09"


def test_with_base_fixture(base):
    assert value09(base) == 91


def test_linked_through_mod04():
    assert linked09(11) == 63
