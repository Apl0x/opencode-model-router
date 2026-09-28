from app.mod04 import value04, tag04, linked04


def test_value_subtracts():
    assert value04(12) == 8


def test_tag():
    assert tag04() == "mod04"


def test_with_base_fixture(base):
    assert value04(base) == 96


def test_linked_through_mod02():
    assert linked04(12) == 40
