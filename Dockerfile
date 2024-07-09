FROM alpine:latest

RUN apk add --no-cache \
	nodejs \
	npm \
	yt-dlp \
	ffmpeg \
	py3-requests


WORKDIR /app/

COPY . .

RUN npm install

CMD node /app/src/bot.js

EXPOSE 3000
