from app.mod07 import value07, tag07, linked07


def test_value_subtracts():
    assert value07(11) == 4


def test_tag():
    assert tag07() == "mod07"


def test_with_base_fixture(base):
    assert value07(base) == 93
