from app.mod06 import value06, tag06, linked06


def test_value_subtracts():
    assert value06(12) == 6


def test_tag():
    assert tag06() == "mod06"
