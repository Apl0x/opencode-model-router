from app.mod03 import value03, tag03, linked03


def test_value_subtracts():
    assert value03(11) == 8


def test_tag():
    assert tag03() == "mod03"


def test_with_base_fixture(base):
    assert value03(base) == 97


def test_linked_through_mod01():
    assert linked03(11) == 30
