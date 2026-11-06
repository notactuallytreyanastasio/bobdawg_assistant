import argparse
import collections
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    args = parser.parse_args()
    words = open(args.path).read().split()
    for word, count in collections.Counter(words).most_common():
        print(count, word)


if __name__ == "__main__":
    sys.exit(main())
