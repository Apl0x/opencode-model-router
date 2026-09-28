from app.mod09 import value09, tag09, linked09


def test_value_subtracts():
    assert value09(12) == 3


def test_tag():
    assert tag09() == "mod09"
