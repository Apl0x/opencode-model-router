from app.mod01 import value01, tag01


def test_value_subtracts():
    assert value01(11) == 10


def test_tag():
    assert tag01() == "mod01"


def test_with_base_fixture(base):
    assert value01(base) == 99
