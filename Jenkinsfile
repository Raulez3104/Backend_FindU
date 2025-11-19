pipeline {
    agent any

    stages {
        stage('Checkout') {
            steps {
                git 'https://github.com/Raulez3104/Backend_FindU.git'
            }
        }

        stage('Install Dependencies') {
            steps {
                sh 'npm install'
            }
        }

        stage('Run Tests') {
            steps {
                sh 'npm test'
            }
        }
    }

    post {
        success {
            echo "Tests ejecutados correctamente."
        }
        failure {
            echo "❌ Los tests fallaron."
        }
    }
}
