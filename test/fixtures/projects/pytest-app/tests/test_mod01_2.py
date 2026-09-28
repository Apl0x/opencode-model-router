from app.mod01 import value01, tag01


def test_value_subtracts():
    assert value01(12) == 11


def test_tag():
    assert tag01() == "mod01"


def test_with_base_fixture(base):
    assert value01(base) == 99


def test_zero():
    assert value01(1) == 0
