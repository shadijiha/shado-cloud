# Step 1: Use Node.js 23 as a base image
FROM node:23-alpine

# Step 2: Install GraphicsMagick for PDF thumbnail generation and xvfb/xdotool/scrot for remote desktop testing
RUN apk add --no-cache graphicsmagick ghostscript scrot xdotool xvfb xterm

# Step 3: Set the working directory inside the container
WORKDIR /usr/src/app

# Step 3: Copy package.json and package-lock.json (or yarn.lock)
COPY package*.json ./

# Step 4: Install dependencies (including dev dependencies)
RUN rm -rf node_modules
RUN npm install

# Step 5: Copy the rest of the application code
COPY . .

# RUN if [ ! -f "node_modules" ]; then \
#         echo "node_modules not found!" && exit 1; \
#     fi

# Step 6: Install NestJS CLI globally
RUN npm install -g @nestjs/cli

RUN mkdir /usr/shado-cloud-data
RUN chmod 777 -R /usr/shado-cloud-data

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Step 7: Expose the port the app runs on
EXPOSE 9000

# Step 8: Run Xvfb and the application
CMD ["/usr/local/bin/docker-entrypoint.sh"]
