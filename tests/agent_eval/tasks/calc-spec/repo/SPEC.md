# calc

`evaluate(text)` takes an arithmetic expression and returns a number.

- Numbers are integers or decimals, such as 12, 0.5 and .5.
- Operators are + - * / % and ^. ^ is power and is right associative: 2^3^2 is 512.
- * / % bind tighter than + -, and ^ binds tighter than those.
- Unary minus binds looser than ^ and tighter than * / %, so -2^2 is -4, 2^-1 is 0.5, and -3%2 is 1.
- Parentheses group. Spaces are ignored between tokens, but 1 2 is an error.
- Names: `pi` is 3.141592653589793. `min(a, b, ...)`, `max(a, b, ...)` and `abs(a)` are functions.
- Integer results stay ints where every input is an int and no / was used: 7%3 is 1, and 2^3 is 8.
  / always gives a float: 4/2 is 2.0.
- Anything else raises `CalcError` with a message, including division or modulo by zero, an
  unknown name, a wrong argument count for abs, min() with no arguments, unbalanced parentheses,
  and empty input. No other exception type may escape.
- It must not use eval or exec.
