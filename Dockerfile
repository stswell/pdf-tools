# PDF tools as a container for the SSW tools server.
# Serves the static site on port 8080 and answers GET /health with 200, as the
# Toolbox expects. The real work happens in the user's browser; the container
# only hands out files. Runs as a non-root user (nginx-unprivileged).
#
#   docker build -t ssw-pdf-tools .
#   docker run --rm -p 8080:8080 ssw-pdf-tools     # http://localhost:8080
FROM nginxinc/nginx-unprivileged:1.27.3-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

# Only the website itself (pages, styles, scripts, images)
COPY *.html style.css /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/
COPY css/    /usr/share/nginx/html/css/
COPY js/     /usr/share/nginx/html/js/

EXPOSE 8080
