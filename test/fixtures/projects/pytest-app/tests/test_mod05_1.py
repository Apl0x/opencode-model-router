from app.mod05 import value05, tag05, linked05


def test_value_subtracts():
    assert value05(11) == 6


def test_tag():
    assert tag05() == "mod05"


def test_with_base_fixture(base):
    assert value05(base) == 95
