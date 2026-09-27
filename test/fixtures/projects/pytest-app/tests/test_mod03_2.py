from app.mod03 import value03, tag03, linked03


def test_value_subtracts():
    assert value03(12) == 9


def test_tag():
    assert tag03() == "mod03"
