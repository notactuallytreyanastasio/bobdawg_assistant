from pager import page_count, page_slice

assert page_count(0, 10) == 0
assert page_count(10, 10) == 1
assert page_count(11, 10) == 2
assert page_slice([1, 2, 3, 4, 5], 1, 2) == [1, 2]
assert page_slice([1, 2, 3, 4, 5], 3, 2) == [5]
print("ok")
