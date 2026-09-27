from app.mod01 import value01, tag01


def test_value_subtracts():
    assert value01(13) == 12


def test_tag():
    assert tag01() == "mod01"
