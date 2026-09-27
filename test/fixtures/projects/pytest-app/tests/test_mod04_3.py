from app.mod04 import value04, tag04, linked04


def test_value_subtracts():
    assert value04(13) == 9


def test_tag():
    assert tag04() == "mod04"
