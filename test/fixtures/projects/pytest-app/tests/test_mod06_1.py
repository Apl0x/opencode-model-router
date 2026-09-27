from app.mod06 import value06, tag06, linked06


def test_value_subtracts():
    assert value06(11) == 5


def test_tag():
    assert tag06() == "mod06"


def test_with_base_fixture(base):
    assert value06(base) == 94


def test_linked_through_mod03():
    assert linked06(11) == 48
