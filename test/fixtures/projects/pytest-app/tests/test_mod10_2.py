from app.mod10 import value10, tag10, linked10


def test_value_subtracts():
    assert value10(12) == 2


def test_tag():
    assert tag10() == "mod10"


def test_with_base_fixture(base):
    assert value10(base) == 90


def test_linked_through_mod05():
    assert linked10(12) == 70
