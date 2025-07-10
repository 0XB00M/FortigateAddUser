# base image
FROM node:20

# ตั้ง working directory
WORKDIR /app

# copy ไฟล์ทั้งหมด
COPY . .

# ติดตั้ง dependencies
RUN npm install

# เปิด port
EXPOSE 3000

# รันแอป
CMD ["node", "index.js"]
