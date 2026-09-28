from app.mod07 import value07, tag07, linked07


def test_value_subtracts():
    assert value07(12) == 5


def test_tag():
    assert tag07() == "mod07"


def test_with_base_fixture(base):
    assert value07(base) == 93


def test_linked_through_mod03():
    assert linked07(12) == 63
