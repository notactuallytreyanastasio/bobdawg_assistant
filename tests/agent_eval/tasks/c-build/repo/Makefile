greet: main.o greet.o
	cc -o greet main.o
main.o: main.c greet.h
	cc -c main.c
greet.o: greet.c greet.h
	cc -c greet.c
